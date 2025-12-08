//
//  toDoListApp.swift
//  toDoList
//
//  Created by Hamza Badri on 06/12/25.
//

import SwiftUI
/*
 MVVM Architecture
 
 model - data point
 view - UI
 veiw mode
 */
@main
struct toDoListApp: App {
    
    @StateObject var listViewModel: ListViewModel = ListViewModel()
    
    var body: some Scene {
        WindowGroup {
            NavigationView{
                ListView()
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .environmentObject(listViewModel)
        }
    }
}
